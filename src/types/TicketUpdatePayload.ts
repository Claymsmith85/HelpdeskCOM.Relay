export interface TicketUpdatedPayload {
    payload:   Payload;
    createdAt: Date;
    eventType: string;
}

export interface Payload {
    ID:                string;
    cc:                any[];
    spam:              Spam;
    events:            Event[];
    rating:            null;
    customFields:      Record<string, string>;
    source:            Source;
    status:            string;
    tagIDs:            any[];
    shortID:           string;
    subject:           string;
    teamIDs:           string[];
    priority:          number;
    createdAt:         Date;
    createdBy:         string;
    followers:         any[];
    licenseID:         number;
    requester:         Requester;
    updatedAt:         Date;
    updatedBy:         string;
    assignment:        NewClass;
    childTickets:      any[];
    integrations:      Integrations;
    parentTicket:      null;
    createdByType:     string;
    lastMessageAt:     Date;
    detectedLanguage:  null;
    ratingRequestSent: boolean;
}

export interface NewClass {
    team:  Agent;
    agent: Agent;
}

export interface Agent {
    ID:   string;
    name: string;
}

export interface Event {
    ID:              number;
    date:            Date;
    type:            string;
    author:          Author;
    source:          Source;
    message?:        Message;
    deliveryStatus?: DeliveryStatus[];
    status?:         Status;
    assignment?:     EventAssignment;
    attachments?:    Attachments;
}

export interface EventAssignment {
    new: NewClass;
    old: Old;
}

export interface Old {
    team: Agent;
}

export interface Attachments {
    files:     File[];
    isPrivate: boolean;
}

export interface File {
    cid:    string;
    url:    string;
    name:   string;
    size:   number;
    type:   string;
    token:  string;
    sha256: string;
}

export interface Author {
    ID:   string;
    name: string;
    type: string;
}

export interface DeliveryStatus {
    date:     Date;
    status:   string;
    entityID: string;
}

export interface Message {
    text:         string;
    isPrivate:    boolean;
    richTextObj:  RichTextObj[] | null;
    richTextHtml: null;
}

export interface RichTextObj {
    type:     string;
    children: Child[];
}

export interface Child {
    text: string;
}

export interface Source {
    type:           string;
    detailedSource: string;
}

export interface Status {
    new: string;
    old: string;
}

export interface Integrations {
}

export interface Requester {
    name:  string;
    email: string;
}

export interface Spam {
    reason: null;
    status: boolean;
}